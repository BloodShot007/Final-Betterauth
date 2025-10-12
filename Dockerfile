# betterauth-service/Dockerfile
FROM node:22-alpine

# Create app directory
WORKDIR /app

# Install deps (use ci for reproducible builds)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# The service listens on 4000
EXPOSE 4000

# Run the service
CMD ["node", "index.js"]
