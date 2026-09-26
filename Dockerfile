FROM node:22-alpine
RUN apk add --no-cache openssl

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
# build tools (vite etc.) are devDependencies: install them for the build, prune afterwards
RUN npm ci --include=dev && npm cache clean --force

COPY . .
RUN npx prisma generate && npm run build && npm prune --omit=dev

EXPOSE 3000
# runs prisma migrate deploy, then starts the server on $PORT
CMD ["npm", "run", "docker-start"]
