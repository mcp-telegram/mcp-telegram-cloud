import type { en } from "./messages/en.js";

/**
 * The message catalog shape, derived from the English source of truth.
 *
 * Every other locale module is typed `: Messages` (not `as const`), so TS
 * forces it to provide exactly these keys with string values — a missing or
 * misspelled key is a compile error, and a stray extra key is too.
 */
export type Messages = {
  readonly [Section in keyof typeof en]: {
    readonly [Key in keyof (typeof en)[Section]]: string;
  };
};

/** Dotted key path into the catalog, e.g. `"login.title"`. Used by `t()`. */
export type MessageKey = {
  [Section in keyof Messages]: `${Section & string}.${keyof Messages[Section] & string}`;
}[keyof Messages];
