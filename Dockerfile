FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install -g npm@11.14.0
RUN npm ci

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g npm@11.14.0
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY db ./db
COPY data ./data
CMD ["npm", "run", "api"]
