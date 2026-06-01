# Code Generation
## Introduction
This document outlines the code generation process.
## Structured Prompt Format
The system prompt is now wrapped in an array with `cache_control: {type: "ephemeral"}`. For example:
```json
{
  "system": [
    {
      "type": "text",
      "text": "You are a test assistant.",
      "cache_control": {
        "type": "ephemeral"
      }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "go"
    }
  ]
}
```
## Cache Control Requirements
The `cache_control` object is required for the system prompt and must have a `type` property set to `ephemeral`.