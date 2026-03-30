#!/bin/bash

# Move to the folder this file lives in — fixes "can't find folder" errors
cd "$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Run the main start script
bash START.sh
