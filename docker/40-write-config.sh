#!/bin/sh
# Writes the app's runtime config from the environment, before nginx starts.
#
# The SPA is a static bundle: anything that varies per deployment cannot be a
# build-time constant, it has to arrive as a file the browser fetches. App.vue
# reads this and renders the analytics tag from it (see
# src/browser/runtime-config.ts).
#
# The nginx image runs every executable in /docker-entrypoint.d/ on startup, so
# this needs no ENTRYPOINT of its own. It rewrites the file whole rather than
# editing it, which keeps it correct across container restarts.
set -eu

CONFIG_PATH="${CONFIG_PATH:-/usr/share/nginx/html/config.json}"

# Backslash-escapes the two characters that would otherwise break out of a JSON
# string literal. Inside the bracket expression a backslash is literal, so the
# class is just {double quote, backslash} and & is the matched character.
json_escape() {
    printf '%s' "$1" | sed 's/["\]/\\&/g'
}

if [ -n "${UMAMI_URL:-}" ] && [ -n "${UMAMI_WEBSITE_ID:-}" ]; then
    umami_url="$(json_escape "$UMAMI_URL")"
    umami_website_id="$(json_escape "$UMAMI_WEBSITE_ID")"

    # Both inputs are non-empty by the test above, so an empty result means the
    # escaping itself broke. Fail the container start rather than serve a
    # config with silently blank values.
    if [ -z "$umami_url" ] || [ -z "$umami_website_id" ]; then
        echo "40-write-config.sh: failed to encode UMAMI_* values" >&2
        exit 1
    fi

    cat > "$CONFIG_PATH" <<EOF
{
  "umami": {
    "url": "$umami_url",
    "websiteId": "$umami_website_id"
  }
}
EOF
    echo "40-write-config.sh: umami enabled -> $UMAMI_URL"
else
    # Both are required: a URL without a website id (or vice versa) is a
    # misconfiguration, not a partial opt-in, and would load a script that
    # reports nothing.
    echo '{}' > "$CONFIG_PATH"
    echo "40-write-config.sh: UMAMI_URL/UMAMI_WEBSITE_ID unset, analytics off"
fi
