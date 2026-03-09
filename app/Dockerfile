FROM node:22-alpine

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY tracing.js .
COPY index.js .

EXPOSE 3000

# --require loads tracing.js before index.js so OTel can patch modules at startup.
# This is the standard pattern for OTel Node.js auto-instrumentation.
CMD ["node", "--require", "./tracing.js", "index.js"]
