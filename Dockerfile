# Step 1: Use official lightweight Node.js LTS Alpine image
FROM node:20-alpine

# Step 2: Set working directory inside container
WORKDIR /usr/src/app

# Step 3: Set production environment
ENV NODE_ENV=production

# Step 4: Copy package manifests first for optimal layer caching
COPY package*.json ./

# Step 5: Install only production dependencies cleanly
RUN npm ci --only=production && npm cache clean --force

# Step 6: Copy the rest of the application files
COPY . .

# Step 7: Switch to non-root user for security
USER node

# Step 8: Document port exposure (Render sets PORT dynamically via env)
EXPOSE 3000

# Step 9: Start the server
CMD ["node", "server.js"]
