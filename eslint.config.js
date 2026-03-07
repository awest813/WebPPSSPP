import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
    {
        ignores: [
            "coverage/**",
            "dist/**",
            "node_modules/**",
            "data/**",
        ],
    },
    // JavaScript files — base rules only
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: {
                console: "readonly",
                window: "readonly",
                document: "readonly",
                navigator: "readonly",
                fetch: "readonly",
                localStorage: "readonly",
                sessionStorage: "readonly",
            },
        },
        rules: {
            "no-var": "warn",
            "prefer-const": "warn",
            "prefer-arrow-callback": "warn",
        },
    },
    // TypeScript files — base + @typescript-eslint/recommended
    {
        files: ["**/*.ts"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            parser: tsParser,
            parserOptions: {
                project: "./tsconfig.json",
            },
            globals: {
                console: "readonly",
                window: "readonly",
                document: "readonly",
                navigator: "readonly",
                fetch: "readonly",
                localStorage: "readonly",
                sessionStorage: "readonly",
            },
        },
        plugins: {
            "@typescript-eslint": tsPlugin,
        },
        rules: {
            // Base quality rules
            "no-var": "error",
            "prefer-const": "warn",
            "prefer-arrow-callback": "warn",

            // TypeScript-ESLint recommended rules (key subset)
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
            "@typescript-eslint/no-floating-promises": "error",
            "@typescript-eslint/no-misused-promises": ["error", {
                checksVoidReturn: {
                    arguments: false,
                },
            }],
            "@typescript-eslint/no-unsafe-assignment": "warn",
            "@typescript-eslint/no-unsafe-member-access": "warn",
            "@typescript-eslint/no-unsafe-call": "warn",
            "@typescript-eslint/no-unsafe-return": "warn",
        },
    },
];
