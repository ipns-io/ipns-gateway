# SPDX-License-Identifier: Apache-2.0

FROM node:20-alpine
WORKDIR /app
COPY server.js /app/server.js
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "/app/server.js"]

