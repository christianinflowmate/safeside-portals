# TypeScript conventions

Node 24 runs `.ts` files directly in **strip-only** mode: types are erased, nothing
is transformed. That keeps the toolchain small — no build step for the API or the
worker — at the cost of three restrictions.

Not allowed anywhere in `apps/api` or `packages/shared`:

- **Parameter properties.** `constructor(readonly model: string)` throws at load.
  Declare the field and assign it in the body.
- **`enum`.** Use `as const` arrays plus a union type. `LINE_TYPES` in
  `packages/shared/src/extraction.ts` is the pattern to copy.
- **`namespace`.**

Import paths inside `packages/shared` and `apps/api` carry the `.ts` extension,
because Node resolves them as real files rather than through a bundler.

`apps/web` goes through Vite and has none of these restrictions.
