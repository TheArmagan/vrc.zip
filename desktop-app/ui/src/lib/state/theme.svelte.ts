/**
 * Theme. Dark is the default and light is opt-in; the choice is a browser-local preference, so
 * it lives in `localStorage` rather than in daemon settings (a second machine should be free to
 * disagree). The inline script in `index.html` applies the same key before first paint.
 */

const STORAGE_KEY = "vrcz.theme";

export type Theme = "dark" | "light";

function read(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

class ThemeState {
  #current = $state<Theme>(read());

  get current(): Theme {
    return this.#current;
  }

  set(theme: Theme): void {
    this.#current = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* the class on <html> still holds for this session */
    }
  }

  toggle(): void {
    this.set(this.#current === "dark" ? "light" : "dark");
  }
}

export const theme = new ThemeState();
