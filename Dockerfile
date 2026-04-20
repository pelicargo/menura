FROM node:22

# Install pnpm (uses the version bundled with the Node image)
RUN corepack enable

WORKDIR /app

# Copy dependency files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install

# Copy source and config
COPY . .

# Build TypeScript
RUN pnpm build

# Expose port
EXPOSE 3000

# Run the application
CMD ["node", "--env-file", ".env", "./dist/app.js"]
