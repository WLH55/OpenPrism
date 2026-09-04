/** 与 prototype/index.html 的 CDN 配置一致：颜色全部映射 CSS 变量 token */
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        surface2: "var(--surface-2)",
        line: "var(--line)",
        ink: "var(--ink)",
        ink2: "var(--ink-2)",
        ink3: "var(--ink-3)",
        accent: "var(--accent)",
        accent2: "var(--accent-2)",
        accent3: "var(--accent-3)",
        warm: "var(--warm)",
        warm2: "var(--warm-2)",
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", '"PingFang SC"', '"Microsoft YaHei"', '"Noto Sans SC"', "sans-serif"],
      },
    },
  },
  plugins: [],
};
