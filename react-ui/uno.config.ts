import { defineConfig, presetIcons, presetUno, presetWind, transformerVariantGroup } from 'unocss'
import presetAnimations from 'unocss-preset-animations'
import { presetShadcn } from 'unocss-preset-shadcn'

export default defineConfig({
  presets: [
    presetUno(),
    presetWind(),
    presetIcons(),
    presetAnimations(),
    presetShadcn({
      color: 'neutral',
      radius: 0.3,
    }),
  ],
  shortcuts: [
    {
      'flex-center': 'flex justify-center items-center',
      'flex-col-center': 'flex flex-col justify-center items-center',
    },
  ],
  preflights: [
    {
      getCSS: () => `
      :root {
        --primary: 19 92% 55%;
        --light-primary: 19 100% 65%;
        --background: 0 0% 6%;
        --secondary-dark: 0 0% 3%;
        --secondary-hover: 0 0% 13%;
        --secondary: 0 0% 6%;
        --secondary-mid-light: 0 0% 8%;
        --secondary-light: 0 0% 16%;
        --primary-light: 210 100% 67%;
        --border: 220 13% 91%;
        --radius: 0.5rem;
        --success: 140 70% 42%;
        --warning: 35 92% 55%;
        --danger: 5 92% 55%;
      }
      `,
    },
  ],
  rules: [
    [/^scrollbar-hide$/, () => {
      return `.scrollbar-hide{scrollbar-width:none}
.scrollbar-hide::-webkit-scrollbar{display:none}`
    }],
  ],
  theme: {
    colors: {
      'primary': 'hsl(var(--primary))',
      'light-primary': 'hsl(var(--light-primary))',
      'primary-light': 'hsl(var(--primary-light))',
      'background': 'hsl(var(--background))',
      'secondary': 'hsl(var(--secondary))',
      'secondary-light': 'hsl(var(--secondary-light))',
      'secondary-mid-light': 'hsl(var(--secondary-mid-light))',
      'secondary-hover': 'hsl(var(--secondary-hover))',
      'secondary-dark': 'hsl(var(--secondary-dark))',
      'success': 'hsl(var(--success))',
      'warning': 'hsl(var(--warning))',
      'danger': 'hsl(var(--danger))',
    },
  },
  transformers: [transformerVariantGroup()],
})
