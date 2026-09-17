import { defineConfig } from "bunup";

export default defineConfig({
  entry: ["src/index.ts"],
  sourceBase: "src",
  sourcemap: true,
  splitting: false,
  dts: true,
  format: ["cjs", "esm"],
});
