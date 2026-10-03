#!/usr/bin/env bash
# Stop the FlowMix server.
pkill -f "^python3 server.py$" && echo "FlowMix stopped" || echo "FlowMix was not running"
