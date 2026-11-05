# /oc

This page covers `/oc`: it prints the bridge status.

Syntax: `/oc`

Example:

```
> /oc
mode: supervised
service: http://127.0.0.1:49374
armed: 1
served: opencode-go/glm-5.3-flash, opencode-go/deepseek-v4.1-flash
ses_…  running  glm-5.3-flash  refactor-parser  attached
```

The command prints the mode, the service URL, the armed count, the served models, and up to eight
threads under the root. Adopted threads come first and carry `attached`. The `batched` part appears
only when the batch is not empty. The thread line shows `id`, `status`, model id, title, and
`attached`; `status` reads `running` while the thread is busy, otherwise it reads the stored
outcome.

The command takes no argument and changes no mode.
