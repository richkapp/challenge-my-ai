import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#111111",
        paper: "#f7f7f7",
        ember: "#f04438",
        violet: "#111111",
        mint: "#ecfdf3",
        fog: "#efefef",
      },
      borderRadius: {
        xl: "0.5rem",
        "2xl": "0.625rem",
        "3xl": "0.75rem",
      },
      boxShadow: {
        brutal: "none",
      },
    },
  },
  plugins: [],
};

export default config;
