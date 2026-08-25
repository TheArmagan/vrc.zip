-- 016_session_environment — what the client was running on, and where its OSC port is.
--
-- VRChat writes a `[UserInfoLogger] Environment Info` block within the first second of every
-- session: build number, Unity version, platform, store, CPU, GPU, memory, OS, and the headset. It
-- is the only place any of that appears, the API has no equivalent, and until now the parser threw
-- it away because it spans several lines and the line parser was stateless.
--
-- ## Why columns and not a JSON blob
--
-- A blob would have survived VRChat adding keys without a migration, which is the whole argument
-- for one. It also makes every question about the data a string operation: "which sessions ran on
-- the Quest build", "did the crash only happen on that GPU", "what build was I on last Tuesday".
-- Those are the questions a session row exists to answer, and the key set has not moved in years.
--
-- Nullable throughout, and null means the block was never seen — a session resumed from the middle
-- of an old log file has no environment block left to read, and that is a normal state rather than
-- a gap to backfill with guesses.

ALTER TABLE sessions ADD COLUMN vrchat_build     TEXT;
ALTER TABLE sessions ADD COLUMN unity_version    TEXT;
ALTER TABLE sessions ADD COLUMN platform         TEXT;
ALTER TABLE sessions ADD COLUMN store            TEXT;
ALTER TABLE sessions ADD COLUMN device_model     TEXT;
ALTER TABLE sessions ADD COLUMN processor_type   TEXT;
ALTER TABLE sessions ADD COLUMN graphics_device  TEXT;
ALTER TABLE sessions ADD COLUMN system_memory    TEXT;
ALTER TABLE sessions ADD COLUMN operating_system TEXT;

-- The headset, or null on a flatscreen client. Distinct from `vr_mode`, which says how the client
-- is *presenting*: a session can report `vr` with an XR device this build has never heard of, and
-- the device name is the half that identifies the hardware.
ALTER TABLE sessions ADD COLUMN xr_device        TEXT;

-- The port the client listens for OSC on. Only the first one advertised is stored: OSCQuery is
-- advertised first, on a random high port, and taking the newest value recorded that one instead.
ALTER TABLE sessions ADD COLUMN osc_port         INTEGER;
