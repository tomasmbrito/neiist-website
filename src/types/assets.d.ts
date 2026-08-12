// Type declarations for static image imports (`import hero from "@/assets/hero.png"`).
//
// Next normally supplies these via the generated `next-env.d.ts`, but that file is gitignored
// and only produced by `next dev` / `next build`. A fresh checkout — which is what CI gets —
// has no such file, so `tsc --noEmit` fails with TS2307 on every image import before the build
// step ever runs. Referencing the types directly from a committed file makes `yarn type:check`
// self-contained instead of depending on generated output.
/// <reference types="next/image-types/global" />
