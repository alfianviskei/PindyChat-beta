/**
 * The deployment's own name and home.
 *
 * These are the fallbacks the shell speaks with before `/api/config` answers
 * with `appTitle`, plus the one place the product URL lives. Keeping them in a
 * single module rather than repeating the literal at each call site means a
 * rebrand is a two-line change, and the tab title, the login wordmark, the
 * footer link and the About blob cannot drift apart from one another.
 *
 * An operator who sets `APP_TITLE` still wins everywhere these are read: each
 * site prefers the startup config and falls back to `APP_NAME` only when that
 * has not arrived, or arrived empty.
 */
export const APP_NAME = 'PindyChat';

/** Canonical product URL, used by the footer's version link. */
export const APP_URL = 'https://chat.pindyyogurt.store';
