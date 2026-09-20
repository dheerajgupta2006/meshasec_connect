import type { Config } from "tailwindcss";

const config: Config = {
  /**
   * Class strategy, not `media`: the user can now override the OS preference
   * from the header toggle. `next-themes` resolves "system" to the same `.dark`
   * class, so OS-driven theming still works exactly as before.
   */
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        "input-strong": "hsl(var(--input-strong))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        "primary-emphasis": {
          DEFAULT: "hsl(var(--primary-emphasis))",
          foreground: "hsl(var(--primary-emphasis-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        "destructive-text": "hsl(var(--destructive-text))",
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      /**
       * Only decorative motion lives here. `tailwindcss-animate` is deliberately
       * not installed, and the global `prefers-reduced-motion` rule in
       * `globals.css` zeroes every animation, so anything defined below must
       * still read correctly when frozen on its first frame.
       */
      keyframes: {
        /**
         * Drives the landing page's language ticker. The track renders its list
         * twice, so shifting by exactly half its width lands back on an
         * identical frame and the loop has no visible seam.
         */
        "marquee-x": {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(-50%)" },
        },
        /** Slow drift for the hero's background gradient blooms. */
        drift: {
          "0%, 100%": { transform: "translate3d(0, 0, 0) scale(1)" },
          "50%": { transform: "translate3d(0, -6%, 0) scale(1.08)" },
        },
      },
      animation: {
        "marquee-x": "marquee-x 44s linear infinite",
        drift: "drift 18s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
