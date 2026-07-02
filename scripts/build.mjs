import { build, defineConfig } from "vite";
import react from "@vitejs/plugin-react";

await build(
  defineConfig({
    configFile: false,
    plugins: [react()],
  })
);
