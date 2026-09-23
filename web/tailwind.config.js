/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: { extend: { colors: {
    white: "rgb(var(--line-rgb) / <alpha-value>)",
    zinc: {
      100: "rgb(var(--ink-strong-rgb) / <alpha-value>)",
      200: "rgb(var(--ink-rgb) / <alpha-value>)",
      300: "rgb(var(--ink-rgb) / <alpha-value>)",
      400: "rgb(var(--ink-muted-rgb) / <alpha-value>)",
      500: "rgb(var(--ink-subtle-rgb) / <alpha-value>)",
      600: "rgb(var(--ink-subtle-rgb) / <alpha-value>)",
      700: "rgb(var(--surface-raised-rgb) / <alpha-value>)",
      800: "rgb(var(--surface-raised-rgb) / <alpha-value>)",
      900: "rgb(var(--surface-rgb) / <alpha-value>)",
      950: "rgb(var(--surface-deep-rgb) / <alpha-value>)",
    },
    amber: { 100: "rgb(var(--warning-rgb) / <alpha-value>)", 200: "rgb(var(--warning-rgb) / <alpha-value>)" },
    rose: { 100: "rgb(var(--danger-rgb) / <alpha-value>)", 200: "rgb(var(--danger-rgb) / <alpha-value>)" },
    sky: { 100: "rgb(var(--blue-aux-rgb) / <alpha-value>)", 200: "rgb(var(--blue-aux-rgb) / <alpha-value>)" },
  } } },
  plugins: [],
};
