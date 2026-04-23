# Uses the official Playwright image – Chromium + all system deps pre-installed.
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Ensure runtime directories exist
RUN mkdir -p sessions public

ENV PORT=3001
EXPOSE 3001

CMD ["node", "server.js"]
