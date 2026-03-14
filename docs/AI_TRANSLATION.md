# AI Translation with Intlayer

This project uses [Intlayer](https://intlayer.org) with AI translation fallback to automatically translate missing locales.

## How It Works

1. **Content Declarations**: Create `.content.ts` files with translations for all supported locales (en, zh, ja, ko)
2. **AI Fallback**: If translations are missing, intlayer can use AI to generate them automatically
3. **Providers**: Supports OpenAI, Anthropic, Mistral, DeepSeek, Gemini, and Ollama

## Configuration

See `intlayer.config.ts`:

```typescript
{
  ai: {
    provider: "openai",
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-4o",
    applicationContext: "Lianki is a spaced repetition learning app...",
    temperature: 0.5,
  }
}
```

## Using AI Translation

### Option 1: Manual Translation Command

Run this command to automatically translate missing keys:

```bash
# Set your OpenAI API key
export OPENAI_API_KEY=your-openai-key-here

# Generate translations for all missing keys
npx intlayer fill

# Or only translate unpushed changes
npx intlayer fill --unpushed --mode fill
```

### Option 2: Intlayer Dashboard (Recommended)

1. Register at [Intlayer Dashboard](https://intlayer.org/tms)
2. Get your access key
3. Add to `.env`:
   ```
   INTLAYER_ACCESS_TOKEN=your-access-token
   ```
4. Remove the `ai` config from `intlayer.config.ts`
5. Intlayer will manage AI translations automatically

## Benefits of Dashboard Approach

- No need to configure AI providers
- More cost-effective (Intlayer optimizes token usage)
- Visual editor for managing translations
- Automatic translation on every push
- Team collaboration features

## Creating New Content Declarations

1. Create a new `.content.ts` file:

```typescript
import { t, type DeclarationContent } from "intlayer";

const myContent = {
  key: "my-component",
  content: {
    title: t({
      en: "Hello",
      zh: "你好",
      ja: "こんにちは",
      ko: "안녕하세요",
    }),
    // Add more translations...
  },
} satisfies DeclarationContent;

export default myContent;
```

2. Use in your component:

**Client Component:**

```tsx
"use client";
import { useIntlayer } from "next-intlayer";

export default function MyComponent() {
  const { title } = useIntlayer("my-component");
  return <h1>{title.value}</h1>;
}
```

**Server Component:**

```tsx
import { useIntlayer } from "next-intlayer/server";

export default async function MyComponent() {
  const { title } = useIntlayer("my-component");
  return <h1>{title.value}</h1>;
}
```

## CI/CD Integration

Add to your GitHub Actions workflow:

```yaml
- name: Generate translations
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  run: npx intlayer fill --unpushed --mode fill
```

## Learn More

- [Intlayer Documentation](https://intlayer.org/doc/concept/auto-fill)
- [Intlayer Configuration](https://intlayer.org/doc/concept/configuration)
- [Intlayer CI/CD](https://intlayer.org/doc/concept/ci-cd)
