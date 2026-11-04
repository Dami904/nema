import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2022, globals: { ...globals.browser, ...globals.node } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Secrets never live in the web app: only VITE_* values reach the bundle,
      // and those are public. Reading anything else from the environment fails lint.
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.object.type='MetaProperty'][object.property.name='env'][property.name!=/^(VITE_[A-Z0-9_]+|DEV|PROD|MODE|BASE_URL|SSR)$/]",
          message: "Only public VITE_* values may be read from import.meta.env in the web app.",
        },
      ],
    },
  },
  {
    // Node scripts run on a developer's machine, not in the bundle.
    files: ["scripts/**/*.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
);
