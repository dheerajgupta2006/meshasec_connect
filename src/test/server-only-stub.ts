/**
 * Test stub for the `server-only` package.
 *
 * The real package throws on import outside a React Server Component, which is
 * exactly the protection we want in the app and exactly what blocks a Node test
 * runner from importing a server module. Vitest aliases `server-only` here so
 * the guard stays real in the build and becomes a no-op under test.
 */
export {};
