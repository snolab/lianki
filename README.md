# Lianki

A modern spaced repetition learning system built with Next.js 15, implementing the FSRS (Free Spaced Repetition System) algorithm for efficient flashcard review and memorization.

## Features

- Spaced repetition learning using the FSRS algorithm
- Multi-user authentication (Email, GitHub, Google OAuth)
- Keyboard shortcuts for quick reviews (1-5 for ratings, HJKL/ASDT navigation)
- Browser integration via userscript (Tampermonkey/Violentmonkey)
- Automatic card scheduling based on difficulty
- Japanese/JLPT content prioritization
- Review tracking and statistics

## Live Demo

https://www.lianki.com/

## Tech Stack

- **Framework**: Next.js 15 with App Router
- **Language**: TypeScript
- **Database**: MongoDB with NextAuth adapter
- **Authentication**: NextAuth.js v5 (Email, GitHub, Google)
- **UI**: Tailwind CSS
- **FSRS Algorithm**: ts-fsrs
- **Runtime**: Bun (package manager)

## Prerequisites

- Node.js 20+ or Bun
- MongoDB instance (local or cloud)
- (Optional) SMTP server for email authentication
- (Optional) GitHub/Google OAuth credentials

## Getting Started

### 1. Clone the repository

```bash
git clone <repository-url>
cd lianki
```

### 2. Install dependencies

```bash
bun install
# or
npm install
```

### 3. Set up environment variables

Copy the example environment file and configure it:

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

```env
# Required
MONGODB_URI=mongodb://localhost:27017/lianki
AUTH_SECRET=<generate with: openssl rand -base64 32>

# Optional - Email Authentication
EMAIL_SERVER=smtp://user:password@smtp.example.com:587
EMAIL_FROM=noreply@yourdomain.com

# Optional - OAuth Providers
AUTH_GITHUB_ID=your-github-client-id
AUTH_GITHUB_SECRET=your-github-client-secret
AUTH_GOOGLE_ID=your-google-client-id
AUTH_GOOGLE_SECRET=your-google-client-secret
```

### 4. Run the development server

```bash
bun dev
# or
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Usage

### Adding Cards

1. **Via Web Interface**: Navigate to `/add-note` and paste a URL with optional title
2. **Via Userscript**: Install the userscript from `/lianki.user.js` and use:
   - `Alt+F`: Add current page
   - `Alt+V`: Add from clipboard
   - `Alt+Shift+V`: Bulk add multiple URLs

### Reviewing Cards

1. Click "Next card" on the homepage or navigate to `/next`
2. Review the card content
3. Rate your recall using keyboard shortcuts:
   - `1` or `H` or `A`: Again (forgot)
   - `2` or `J` or `S`: Hard (difficult to recall)
   - `3` or `K` or `D`: Good (correct recall)
   - `4` or `L` or `T`: Easy (very easy recall)
   - `5`: Delete card

### Card Management

- View all cards on the homepage
- See total and due card counts
- Delete individual cards via the delete button
- Review and close window automatically after rating

## API Routes

- `/api/fsrs/next` - Get next due card
- `/api/fsrs/all` - Open all due cards
- `/api/fsrs/repeat?url=<url>` - Preview card
- `/api/fsrs/review/:rating?url=<url>` - Submit review
- `/api/fsrs/delete?url=<url>` - Delete card

## Development

### Code Quality

```bash
# Run linting and formatting
bun fix

# Build for production
bun build
```

### Git Hooks

The project uses Husky for pre-commit hooks. The hook runs `bun fix` automatically before each commit.

## Deployment

### Vercel (Recommended)

1. Push your code to GitHub
2. Import the project in Vercel
3. Add environment variables in Vercel dashboard
4. Deploy

### Docker

```bash
docker-compose up
```

## Project Structure

```
├── app/
│   ├── page.tsx              # Homepage with card list
│   ├── fsrs.ts               # Core FSRS handler logic
│   ├── db.ts                 # MongoDB client setup
│   ├── api/                  # API routes
│   │   ├── fsrs/             # FSRS API endpoints
│   │   └── auth/             # NextAuth routes
│   └── [routes]/             # Page routes
├── auth.ts                   # NextAuth configuration
├── auth.config.ts            # Auth providers config
├── public/
│   └── lianki.user.js        # Tampermonkey userscript
└── .env.example              # Environment variables template
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

[Add your license here]

## Author

snomiao <snomiao@gmail.com>
