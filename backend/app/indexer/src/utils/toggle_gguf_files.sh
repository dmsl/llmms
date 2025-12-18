#!/bin/bash

# Usage: ./toggle_gguf_files.sh disable|enable partial_filename

# CONFIGURATION
CODEWORD="_DISABLED"  # The string to disable or enable from filenames
DIR="enter path to local models here" # Directory to search

# ARGUMENT CHECKS
if [ $# -lt 2 ]; then
    echo "Usage: $0 disable|enable partial1 [partial2 ... partialN]"
    exit 1
fi

ACTION=$1
shift  # remove first argument, now $@ contains all partial filenames

for PARTIAL in "$@"; do
    # Case-insensitive file search with find
    find "$DIR" -maxdepth 1 -type f -iname "*$PARTIAL*" -print0 | while IFS= read -r -d '' FILE; do
        BASENAME=$(basename "$FILE")
        DIRNAME=$(dirname "$FILE")

        BASENAME_LC=$(echo "$BASENAME" | tr '[:upper:]' '[:lower:]')
        CODEWORD_LC=$(echo "$CODEWORD" | tr '[:upper:]' '[:lower:]')

        case $ACTION in
            disable)
                if [[ "$BASENAME_LC" != *"$CODEWORD_LC"* ]]; then
                    mv "$FILE" "$DIRNAME/$BASENAME$CODEWORD"
                    echo "Added codeword: $BASENAME -> $BASENAME$CODEWORD"
                else
                    echo "Skipped (already has codeword): $BASENAME"
                fi
                ;;
            enable)
                if [[ "$BASENAME_LC" == *"$CODEWORD_LC"* ]]; then
                    # Remove codeword, case-insensitive
                    NEWNAME=$(echo "$BASENAME" | sed "s/$CODEWORD//I")
                    mv "$FILE" "$DIRNAME/$NEWNAME"
                    echo "Removed codeword: $BASENAME -> $NEWNAME"
                else
                    echo "Skipped (no codeword to remove): $BASENAME"
                fi
                ;;
            *)
                echo "Unknown action: $ACTION. Use 'disable' or 'enable'."
                exit 1
                ;;
        esac
    done
done