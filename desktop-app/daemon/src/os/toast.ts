/**
 * A real Windows toast: buttons, an image, a scenario, and a callback when somebody presses one.
 *
 * ## What this replaced, and why it had to
 *
 * The old notifier spawned PowerShell and drove `ToastNotificationManager` through its WinRT bridge.
 * That works for two lines of text and can never do anything else, because the process that raised
 * the toast is gone a second later — and a toast's `Activated` event is delivered *to the process
 * that created it*. No process, no callback. Buttons that cannot report being pressed are not
 * buttons.
 *
 * So this talks to WinRT directly, over `bun:ffi`. It is more code than a script by a wide margin,
 * and it is the only shape in which the feature exists at all.
 *
 * ## The three things that make an unpackaged app able to toast
 *
 * 1. **An AppUserModelID on a Start menu shortcut.** `os/shortcut.ts` writes it. Without one,
 *    `CreateToastNotifierWithId` succeeds and `Show` silently does nothing.
 * 2. **A single-threaded apartment with a pumped message loop.** `os/com.ts` initialises it and
 *    `os/message-pump.ts` pumps it. The activation callback arrives as a COM call, and a COM call
 *    into an STA is a window message.
 * 3. **A handler object that is deliberately *not* agile.** See {@link createHandler}. Refusing
 *    `IAgileObject` is what makes COM marshal the call back to our thread instead of delivering it
 *    on whichever pool thread the notification platform happened to use — which for a JavaScript
 *    runtime is not a race, it is a crash.
 *
 * ## Vtable indices
 *
 * Every interface here derives from `IInspectable`, so its own methods start at slot 6: `IUnknown`
 * takes 0 to 2 and `GetIids`/`GetRuntimeClassName`/`GetTrustLevel` take 3 to 5. Both the indices and
 * the IIDs in this file were read out of the WinRT metadata on this machine rather than remembered,
 * because a wrong index is not an error — it is a different function, called with the wrong
 * arguments, on the ABI's terms. `IToastNotification` is the one that catches people out: `Dismissed`
 * is declared *before* `Activated`, so `add_Activated` is slot 11 and not slot 9.
 */

import { dlopen, FFIType, JSCallback, ptr, read, suffix, toArrayBuffer } from "bun:ffi";
import { call, ensureApartment, guid, queryInterface, release, S_OK } from "./com.ts";
import { wide } from "./message-pump.ts";

const IS_WINDOWS = process.platform === "win32";

/* -------------------------------------------------------------------------------------------- */
/* Interface identifiers                                                                          */
/* -------------------------------------------------------------------------------------------- */

const IID_IUnknown = "00000000-0000-0000-C000-000000000046";
const IID_IInspectable = "AF86E2E0-B12D-4C6A-9C5A-D7AA65101E90";
/**
 * `IAgileObject`, which our handler answers **no** to. That refusal is load-bearing; see
 * {@link createHandler}.
 */
const IID_IAgileObject = "94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90";

const IID_IToastNotificationManagerStatics = "50AC103F-D235-4598-BBEF-98FE4D1A3AD4";
const IID_IToastNotificationFactory = "04124B20-82C6-4229-B109-FD9ED4662B53";
/** Tag and group, which is how a toast is addressed after it has been shown. */
const IID_IToastNotification2 = "9DFB9FD1-143A-490E-90BF-B9FBA7132DE7";
const IID_IXmlDocument = "F7F3A506-1E87-42D6-BCFB-B8C809FA5494";
const IID_IXmlDocumentIO = "6CD0E74E-EE65-4489-9EBF-CA43E87BA637";
const IID_IToastActivatedEventArgs = "E3BF92F3-C197-436F-8265-0625824F8DAC";
const IID_IPropertyValueStatics = "629BDBC8-D932-4FF4-96B9-8D96C5C1E858";
const IID_IReference_DateTime = "5541D8A7-497C-5AA4-86FC-7713ADBF2A2C";

/**
 * The two handler IIDs, which are *computed* rather than declared.
 *
 * A parameterised WinRT interface has no fixed identifier: `ITypedEventHandler<A, B>`'s IID is a
 * SHA-1 over the type signature, so `<ToastNotification, IInspectable>` and
 * `<ToastNotification, ToastDismissedEventArgs>` are two different interfaces with no relationship a
 * reader can see. These were taken from the projection on this machine, which computes them the
 * same way the runtime does.
 */
const PIID_ActivatedHandler = "AB54DE2D-97D9-5528-B6AD-105AFE156530";
const PIID_DismissedHandler = "61C2402F-0ED0-5A18-AB69-59F4AA99A368";

/** `E_NOINTERFACE`: the answer to everything the handler is not, `IAgileObject` included. */
const E_NOINTERFACE = -2147467262;

/** Runtime class names, which is how WinRT spells a CLSID. */
const CLASS_ToastNotificationManager = "Windows.UI.Notifications.ToastNotificationManager";
const CLASS_ToastNotification = "Windows.UI.Notifications.ToastNotification";
const CLASS_XmlDocument = "Windows.Data.Xml.Dom.XmlDocument";
const CLASS_PropertyValue = "Windows.Foundation.PropertyValue";

/** Vtable slots, all counted from 6. See the note at the top of the file. */
const Statics = { CreateToastNotifierWithId: 7 };
const Factory = { CreateToastNotification: 6 };
const Notifier = { Show: 6, Hide: 7 };
const Notification = { put_ExpirationTime: 7, add_Dismissed: 9, add_Activated: 11 };
const Notification2 = { put_Tag: 6, put_Group: 8 };
const DocumentIO = { LoadXml: 6 };
const ActivatedArgs = { get_Arguments: 6 };
const PropertyValue = { CreateDateTime: 21 };

/* -------------------------------------------------------------------------------------------- */
/* combase                                                                                        */
/* -------------------------------------------------------------------------------------------- */

interface Combase {
  RoActivateInstance: (classId: number, out: Uint8Array) => number;
  RoGetActivationFactory: (classId: number, iid: Uint8Array, out: Uint8Array) => number;
  WindowsCreateString: (source: Uint8Array, length: number, out: Uint8Array) => number;
  WindowsDeleteString: (handle: number) => number;
  WindowsGetStringRawBuffer: (handle: number, length: Uint8Array | null) => number;
}

let combase: Combase | null = null;
let attempted = false;

function load(): Combase | null {
  if (attempted) return combase;
  attempted = true;
  if (!IS_WINDOWS) return null;
  try {
    combase = dlopen(`combase.${suffix}`, {
      RoActivateInstance: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      RoGetActivationFactory: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      WindowsCreateString: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
      WindowsDeleteString: { args: [FFIType.ptr], returns: FFIType.i32 },
      WindowsGetStringRawBuffer: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    }).symbols as unknown as Combase;
  } catch {
    combase = null;
  }
  return combase;
}

/** Whether this machine can raise a WinRT toast at all. Cheap after the first call. */
export function toastSupported(): boolean {
  return IS_WINDOWS && load() !== null && ensureApartment();
}

/* -------------------------------------------------------------------------------------------- */
/* HSTRING and out-parameters                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** An 8-byte buffer for a `void**`, with the address read back out. */
function out(): Uint8Array {
  return new Uint8Array(8);
}

function pointerIn(buffer: Uint8Array): number {
  return Number(new DataView(buffer.buffer).getBigUint64(0, true));
}

/**
 * An `HSTRING` we own, and must delete.
 *
 * The length excludes the terminator, which `wide` includes — hence the `- 1`. Handing
 * `WindowsCreateString` a length that counts the NUL produces a string whose last character is a
 * NUL, which then shows up in a toast as a stray box rather than as an error.
 */
function hstring(text: string): number {
  const lib = load();
  if (lib === null) return 0;
  const buffer = wide(text);
  const handle = out();
  if (lib.WindowsCreateString(buffer, buffer.length / 2 - 1, handle) !== S_OK) return 0;
  return pointerIn(handle);
}

function deleteHstring(handle: number): void {
  const lib = load();
  if (lib === null || handle === 0) return;
  try {
    lib.WindowsDeleteString(handle);
  } catch {
    // Freeing on a teardown path.
  }
}

/** Reads an `HSTRING` we were handed. Returns "" for the null handle, which is the empty string. */
function readHstring(handle: number): string {
  const lib = load();
  if (lib === null || handle === 0) return "";
  const address = lib.WindowsGetStringRawBuffer(handle, null);
  if (address === 0) return "";
  let text = "";
  for (let offset = 0; offset < 65_536; offset += 2) {
    const unit = read.u16(address, offset);
    if (unit === 0) break;
    text += String.fromCharCode(unit);
  }
  return text;
}

/** `RoActivateInstance`, then `QueryInterface` to what the caller actually wants. */
function activate(className: string, iid: string): number {
  const lib = load();
  if (lib === null || !ensureApartment()) return 0;
  const name = hstring(className);
  if (name === 0) return 0;
  const inspectable = out();
  try {
    if (lib.RoActivateInstance(name, inspectable) !== S_OK) return 0;
  } catch {
    return 0;
  } finally {
    deleteHstring(name);
  }
  const object = pointerIn(inspectable);
  if (object === 0) return 0;
  const wanted = queryInterface(object, guid(iid));
  release(object);
  return wanted;
}

/** `RoGetActivationFactory`: the statics of a runtime class. */
function factory(className: string, iid: string): number {
  const lib = load();
  if (lib === null || !ensureApartment()) return 0;
  const name = hstring(className);
  if (name === 0) return 0;
  const result = out();
  try {
    if (lib.RoGetActivationFactory(name, guid(iid), result) !== S_OK) return 0;
  } catch {
    return 0;
  } finally {
    deleteHstring(name);
  }
  return pointerIn(result);
}

/* -------------------------------------------------------------------------------------------- */
/* A COM object implemented in JavaScript                                                         */
/* -------------------------------------------------------------------------------------------- */

interface Handler {
  readonly pointer: number;
  dispose(): void;
}

/**
 * Builds an `ITypedEventHandler` whose `Invoke` is a JavaScript function.
 *
 * A COM object is a pointer to a pointer to an array of function pointers, so that is what this
 * assembles by hand: four `JSCallback`s, a vtable holding their addresses, and an object whose only
 * field is the vtable's address. Every buffer is held in a closure that lives as long as the handler
 * does — a `Uint8Array` collected while Windows still holds a pointer into it is a use-after-free
 * that reproduces on somebody else's machine and not on yours.
 *
 * **`QueryInterface` says no to `IAgileObject`, and that is the whole design.** Answering yes means
 * "call me on any thread you like", and the notification platform takes it up: the callback then
 * arrives on an RPC pool thread, where touching a JavaScript heap owned by another thread is a
 * crash rather than a race you might get away with. Saying no makes COM marshal the call back into
 * the apartment the handler was created in, which is our STA, which our message loop is pumping. So
 * `Invoke` runs on the same thread as everything else, from inside our own `PeekMessageW`.
 *
 * `AddRef` and `Release` return a fixed 1 and free nothing. The lifetime is ours: the handler dies
 * when the toast it belongs to is disposed, and never because a refcount reached zero.
 */
function createHandler(
  piid: string,
  invoke: (sender: number, args: number) => void,
): Handler | null {
  const accepted = [piid, IID_IUnknown, IID_IInspectable].map((value) => guid(value));
  const agile = guid(IID_IAgileObject);

  const queryInterfaceCallback = new JSCallback(
    (self: number, riid: number, ppv: number): number => {
      try {
        if (ppv !== 0) new DataView(toArrayBuffer(ppv, 0, 8)).setBigUint64(0, 0n, true);
        // Named rather than merely absent from the list, because "no" is the answer with the
        // consequences: saying yes here is what would move the callback onto a pool thread.
        if (sameGuid(riid, agile)) return E_NOINTERFACE;
        for (const candidate of accepted) {
          if (!sameGuid(riid, candidate)) continue;
          if (ppv !== 0) new DataView(toArrayBuffer(ppv, 0, 8)).setBigUint64(0, BigInt(self), true);
          return S_OK;
        }
        return E_NOINTERFACE;
      } catch {
        return E_NOINTERFACE;
      }
    },
    { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  );
  const addRef = new JSCallback(() => 1, { args: [FFIType.ptr], returns: FFIType.u32 });
  const releaseCallback = new JSCallback(() => 1, { args: [FFIType.ptr], returns: FFIType.u32 });
  const invokeCallback = new JSCallback(
    (_self: number, sender: number, args: number): number => {
      try {
        invoke(sender, args);
      } catch {
        // Thrown across a foreign stack frame is not a thing to allow. The queue this feeds is
        // drained on our own stack, where an exception is an ordinary exception.
      }
      return S_OK;
    },
    { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  );

  const slots = [queryInterfaceCallback, addRef, releaseCallback, invokeCallback];
  if (slots.some((slot) => slot.ptr === null)) {
    for (const slot of slots) slot.close();
    return null;
  }

  const vtable = new Uint8Array(8 * slots.length);
  const vtableView = new DataView(vtable.buffer);
  slots.forEach((slot, index) => {
    vtableView.setBigUint64(index * 8, BigInt(slot.ptr ?? 0), true);
  });

  const object = new Uint8Array(8);
  new DataView(object.buffer).setBigUint64(0, BigInt(ptr(vtable)), true);

  let disposed = false;
  return {
    pointer: ptr(object),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // The buffers are named here so nothing collects them before this point.
      vtableView.setBigUint64(0, 0n, true);
      new DataView(object.buffer).setBigUint64(0, 0n, true);
      for (const slot of slots) slot.close();
    },
  };
}

/** Compares a `REFIID` we were handed against one of ours, sixteen bytes at a time. */
function sameGuid(address: number, expected: Uint8Array): boolean {
  if (address === 0) return false;
  const view = new DataView(expected.buffer);
  return (
    read.u64(address, 0) === view.getBigUint64(0, true) &&
    read.u64(address, 8) === view.getBigUint64(8, true)
  );
}

/* -------------------------------------------------------------------------------------------- */
/* Showing one                                                                                    */
/* -------------------------------------------------------------------------------------------- */

export interface ToastRequest {
  /** The whole `<toast>` document. Built by `desktop-notification.ts`, which is where it is tested. */
  readonly xml: string;
  /**
   * The tag, which is how the same notification is replaced rather than repeated.
   *
   * Windows caps it at 64 characters and rejects anything longer, taking the whole `Show` with it,
   * so the caller trims. Empty means "do not set one".
   */
  readonly tag?: string;
  readonly group?: string;
  /** Unix ms after which Windows removes it from the Action Center by itself. */
  readonly expiresAt?: number;
}

export interface ToastCallbacks {
  /** The `arguments` of whatever was pressed: the toast's own `launch`, or a button's. */
  onActivated(argumentsText: string): void;
  onDismissed?(): void;
}

export interface LiveToast {
  /** Takes it off the screen and lets go of the handlers. Safe to call twice. */
  close(): void;
}

/** Kept alive for as long as Windows might still call into them. */
const live = new Set<{ dispose(): void }>();

/**
 * Raises a toast under `appId`, and reports what happens to it.
 *
 * Returns null when it could not be shown, which covers a machine with no combase, an apartment that
 * could not be initialised, and an `appId` with no shortcut behind it. None of those is an error
 * worth throwing over: the caller's answer to all three is the same sentence about a notification
 * that did not appear.
 */
export function showToast(
  appId: string,
  request: ToastRequest,
  callbacks: ToastCallbacks,
): LiveToast | null {
  if (!toastSupported()) return null;

  let document = 0;
  let toast = 0;
  let notifier = 0;
  let activated: Handler | null = null;
  let dismissed: Handler | null = null;

  const cleanup = (): void => {
    activated?.dispose();
    dismissed?.dispose();
    release(toast);
    release(notifier);
    release(document);
  };

  try {
    document = loadXml(request.xml);
    if (document === 0) return null;

    toast = createNotification(document);
    if (toast === 0) {
      cleanup();
      return null;
    }

    applyTag(toast, request.tag, request.group);
    if (request.expiresAt !== undefined) applyExpiry(toast, request.expiresAt);

    /*
     * The handlers, and the reason they only queue.
     *
     * `Invoke` runs inside a COM call, which is inside `DispatchMessageW`, which is inside the pump's
     * tick. Reading the event arguments there is fine — it is a vtable call on our own thread — but
     * running a caller's handler there is not: it would be arbitrary JavaScript on a foreign stack,
     * where a throw has nowhere to go. So `Invoke` extracts the one string it needs and hands the
     * rest to a microtask.
     */
    activated = createHandler(PIID_ActivatedHandler, (_sender, args) => {
      const text = activationArguments(args);
      queueMicrotask(() => {
        callbacks.onActivated(text);
      });
    });
    if (activated === null) {
      cleanup();
      return null;
    }
    const activatedToken = out();
    if (
      call(
        toast,
        Notification.add_Activated,
        [FFIType.ptr, FFIType.ptr],
        [activated.pointer, activatedToken],
      ) !== S_OK
    ) {
      cleanup();
      return null;
    }

    if (callbacks.onDismissed !== undefined) {
      const onDismissed = callbacks.onDismissed;
      dismissed = createHandler(PIID_DismissedHandler, () => {
        queueMicrotask(onDismissed);
      });
      if (dismissed !== null) {
        const dismissedToken = out();
        call(
          toast,
          Notification.add_Dismissed,
          [FFIType.ptr, FFIType.ptr],
          [dismissed.pointer, dismissedToken],
        );
      }
    }

    notifier = createNotifier(appId);
    if (notifier === 0) {
      cleanup();
      return null;
    }

    if (call(notifier, Notifier.Show, [FFIType.ptr], [toast]) !== S_OK) {
      cleanup();
      return null;
    }

    let closed = false;
    const handle = {
      dispose(): void {
        if (closed) return;
        closed = true;
        live.delete(handle);
        try {
          call(notifier, Notifier.Hide, [FFIType.ptr], [toast]);
        } catch {
          // Already gone, which is the ordinary case.
        }
        cleanup();
      },
    };
    live.add(handle);
    return {
      close(): void {
        handle.dispose();
      },
    };
  } catch {
    cleanup();
    return null;
  }
}

/** Everything still on screen, let go of. For a daemon shutting down. */
export function closeAllToasts(): void {
  for (const handle of [...live]) handle.dispose();
}

function loadXml(xml: string): number {
  const io = activate(CLASS_XmlDocument, IID_IXmlDocumentIO);
  if (io === 0) return 0;
  const text = hstring(xml);
  if (text === 0) {
    release(io);
    return 0;
  }
  const loaded = call(io, DocumentIO.LoadXml, [FFIType.ptr], [text]);
  deleteHstring(text);
  if (loaded !== S_OK) {
    release(io);
    return 0;
  }
  const document = queryInterface(io, guid(IID_IXmlDocument));
  release(io);
  return document;
}

function createNotification(document: number): number {
  const notificationFactory = factory(CLASS_ToastNotification, IID_IToastNotificationFactory);
  if (notificationFactory === 0) return 0;
  const result = out();
  const created = call(
    notificationFactory,
    Factory.CreateToastNotification,
    [FFIType.ptr, FFIType.ptr],
    [document, result],
  );
  release(notificationFactory);
  return created === S_OK ? pointerIn(result) : 0;
}

function createNotifier(appId: string): number {
  const statics = factory(CLASS_ToastNotificationManager, IID_IToastNotificationManagerStatics);
  if (statics === 0) return 0;
  const id = hstring(appId);
  if (id === 0) {
    release(statics);
    return 0;
  }
  const result = out();
  const created = call(
    statics,
    Statics.CreateToastNotifierWithId,
    [FFIType.ptr, FFIType.ptr],
    [id, result],
  );
  deleteHstring(id);
  release(statics);
  return created === S_OK ? pointerIn(result) : 0;
}

/** Tag and group, on `IToastNotification2`. Best-effort: a toast without them still shows. */
function applyTag(toast: number, tag: string | undefined, group: string | undefined): void {
  if ((tag ?? "") === "" && (group ?? "") === "") return;
  const second = queryInterface(toast, guid(IID_IToastNotification2));
  if (second === 0) return;
  try {
    if (tag !== undefined && tag !== "") {
      const handle = hstring(tag);
      call(second, Notification2.put_Tag, [FFIType.ptr], [handle]);
      deleteHstring(handle);
    }
    if (group !== undefined && group !== "") {
      const handle = hstring(group);
      call(second, Notification2.put_Group, [FFIType.ptr], [handle]);
      deleteHstring(handle);
    }
  } finally {
    release(second);
  }
}

/**
 * `ExpirationTime`, which is an `IReference<DateTime>` and therefore three calls rather than one.
 *
 * A WinRT `DateTime` counts 100-nanosecond intervals from 1601-01-01, which is `FILETIME`'s epoch
 * and not Unix's — 11644473600 seconds earlier. Getting that constant wrong sets an expiry in the
 * seventeenth century, and a toast that expired four hundred years ago is one that never appears.
 */
function applyExpiry(toast: number, expiresAt: number): void {
  const statics = factory(CLASS_PropertyValue, IID_IPropertyValueStatics);
  if (statics === 0) return;
  const boxed = out();
  try {
    const ticks = (BigInt(Math.round(expiresAt)) + 11_644_473_600_000n) * 10_000n;
    if (
      call(statics, PropertyValue.CreateDateTime, [FFIType.i64, FFIType.ptr], [ticks, boxed]) !==
      S_OK
    ) {
      return;
    }
    const inspectable = pointerIn(boxed);
    if (inspectable === 0) return;
    const reference = queryInterface(inspectable, guid(IID_IReference_DateTime));
    release(inspectable);
    if (reference === 0) return;
    call(toast, Notification.put_ExpirationTime, [FFIType.ptr], [reference]);
    release(reference);
  } finally {
    release(statics);
  }
}

/**
 * The `arguments` string off a `ToastActivatedEventArgs`.
 *
 * Runs inside `Invoke`, so it is written to answer "" for everything that could go wrong rather than
 * to throw: an activation we cannot read is a click we cannot route, and the caller's answer to that
 * is the same as its answer to a click on the body.
 */
function activationArguments(args: number): string {
  if (args === 0) return "";
  const activatedArgs = queryInterface(args, guid(IID_IToastActivatedEventArgs));
  if (activatedArgs === 0) return "";
  const handle = out();
  try {
    if (call(activatedArgs, ActivatedArgs.get_Arguments, [FFIType.ptr], [handle]) !== S_OK) {
      return "";
    }
    const value = pointerIn(handle);
    const text = readHstring(value);
    deleteHstring(value);
    return text;
  } finally {
    release(activatedArgs);
  }
}
