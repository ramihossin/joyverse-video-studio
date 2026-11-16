FROM ghcr.io/lcy362/free-short-video:latest

# Keep credentials out of the image and Git repository.
ENV AGNES_CONFIG_DIR=/tmp/agnes_config
COPY run_secure.py /app/run_secure.py

# Wrap the upstream FastAPI app with HTTP Basic authentication before exposing it.
CMD ["python", "/app/run_secure.py"]
