import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";

// FIXED (planning tier, Phase 8 pass): the previous config set
// `languageOptions.parser: "typescript-eslint"` — a bare string, which is not
// a valid value for ESLint flat config (`parser` must be the actual parser
// module/object). `typescript-eslint` was also never declared as a dependency.
// This meant `npm run lint` would have failed with a config error the first
// time anyone actually ran it. Using `tseslint.config(...)` + `tseslint.configs.recommended`
// wires the real parser/plugin in correctly.
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "*.config.js", "*.config.mjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      "prettier/prettier": "warn",
      // TS's own noUnusedLocals/noUnusedParameters (tsconfig.json) already cover this;
      // avoid double-reporting between tsc and eslint.
      "@typescript-eslint/no-unused-vars": "off",
      // Dynamic imports of optional dependencies (DownloadManager.ts, jobStore.ts) are
      // deliberately loosely typed — see the NOTE comment in DownloadManager.tryCompressGlb.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  prettier
);
