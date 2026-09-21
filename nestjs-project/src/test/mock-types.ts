/**
 * A mocked collaborator: every member is a jest mock function.
 *
 * Preferred over `jest.Mocked<T>` in assertions. `jest.Mocked<T>` keeps the
 * original method signatures, so referencing one unbound (`expect(svc.method)`)
 * is reported by `@typescript-eslint/unbound-method` — correctly, since a real
 * method could depend on `this`. A mock is a plain function, and saying so in
 * the type is both more accurate and free of the warning.
 */
export type MockedService<T> = { [K in keyof T]: jest.Mock };
