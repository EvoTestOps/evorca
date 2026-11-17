FROM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /opt/agent/requirements.txt
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir --require-hashes -r /opt/agent/requirements.txt
ENV PATH=/opt/venv/bin:$PATH HOME=/tmp PYTHONDONTWRITEBYTECODE=1
WORKDIR /agent
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY background.json ./
COPY src/ ./src/
ENTRYPOINT ["node", "src/main.ts"]
