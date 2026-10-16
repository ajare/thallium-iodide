#!/bin/bash

npm ci
npm run install:local
systemctl --user restart thallium-iodide
