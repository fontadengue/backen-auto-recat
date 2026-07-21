# Imagen oficial de Playwright: ya trae Chromium + todas las librerías
# del sistema necesarias (libglib, libnss3, etc). Evita el problema de
# Nixpacks donde las libs instaladas en el build no llegan al runtime.
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
