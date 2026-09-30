import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "dist"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      complexity: ["error", 8],
      "max-depth": ["error", 3],
      "@typescript-eslint/switch-exhaustiveness-check": "off",
    },
  },
);
