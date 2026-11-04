import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const ENV_RULES = [
  {
    selector: "MemberExpression[object.name='env'][property.name!=/^VITE_[A-Z0-9_]+$/]",
    message: "Only public VITE_* values may be read from the environment in the web app.",
  },
  {
    selector: "MemberExpression[object.object.type='MetaProperty'][object.property.name='env'][property.name!=/^VITE_[A-Z0-9_]+$/]",
    message: "Only public VITE_* values may be read from the environment in the web app.",
  },
  {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message: "The web app runs in the browser; read configuration through src/lib/config.ts.",
  },
];
const NOT_OUTSIDE_CONFIG = {
  selector: "MemberExpression[object.type='MetaProperty'][property.name='env']",
  message: "Read the environment in src/lib/config.ts only.",
};

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
      // and those are public. The environment is read in src/lib/config.ts alone.
      "no-restricted-syntax": ["error", ...ENV_RULES, NOT_OUTSIDE_CONFIG],
    },
  },
  {
    files: ["src/lib/config.ts"],
    rules: { "no-restricted-syntax": ["error", ...ENV_RULES] },
  },
  {
    // Node scripts run on a developer's machine, not in the bundle.
    files: ["scripts/**/*.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
);
