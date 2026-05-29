module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    project: ["tsconfig.json"],
    tsconfigRootDir: __dirname,
  },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "google",
  ],
  plugins: ["@typescript-eslint"],
  ignorePatterns: [
    "/lib/**/*",
    "/node_modules/**/*",
    ".eslintrc.js",
  ],
  rules: {
    "quotes": ["error", "double", { "allowTemplateLiterals": true }],
    "prefer-arrow-callback": "error",
    "no-restricted-globals": ["error", "name", "length"],

    // Google preset is heavy on JSDoc and 80-col lines; TypeScript types
    // already carry the contracts and modern editors handle wider lines.
    "require-jsdoc": "off",
    "valid-jsdoc": "off",
    "max-len": ["warn", { "code": 120, "ignoreUrls": true, "ignoreStrings": true, "ignoreTemplateLiterals": true }],

    // TypeScript-aware unused-vars (lets us prefix with _ to silence).
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
  },
  overrides: [
    {
      files: ["**/*.spec.ts"],
      env: { mocha: true },
    },
  ],
};
