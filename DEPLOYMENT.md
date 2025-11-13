# Deployment Guide

## Vercel Deployment

This project is configured to deploy to Vercel. Follow these steps:

### Environment Variables

Set these environment variables in your Vercel dashboard:

- `MONGODB_URI` - Your MongoDB connection string
- `NEXTAUTH_SECRET` - A random string for NextAuth.js
- `NEXTAUTH_URL` - Your app's URL (e.g., https://yourapp.vercel.app)

### GitHub Actions Setup

For automated deployments, add these secrets to your GitHub repository:

- `VERCEL_TOKEN` - Your Vercel token
- `VERCEL_ORG_ID` - Your Vercel organization ID
- `VERCEL_PROJECT_ID` - Your Vercel project ID

To get these values:
1. Install Vercel CLI: `npm i -g vercel`
2. Run `vercel login`
3. Run `vercel link` in your project
4. Run `vercel env pull .env.local` to see your project config

### Manual Deployment

1. Install Vercel CLI: `npm i -g vercel`
2. Run `vercel` in the project directory
3. Follow the prompts to deploy

## Fixed Issues

- ✅ TypeScript compilation errors with sflow library
- ✅ MongoDB connection during build time
- ✅ Environment variable handling
- ✅ Next.js configuration for production builds