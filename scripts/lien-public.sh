#!/bin/sh
# Affiche le lien public actuel du jeu (à envoyer aux potes).
cd "$(dirname "$0")/.." || exit 1
url=$(docker compose logs tunnel 2>/dev/null | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -n 1)
if [ -n "$url" ]; then
  echo "Lien du jeu : $url"
else
  echo "Lien pas encore disponible : attends quelques secondes et relance ce script."
  echo "(Vérifie que le tunnel tourne avec : docker compose ps)"
fi
