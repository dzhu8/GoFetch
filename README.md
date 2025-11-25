# GoFetch
Live index of your codebase to identify the correct files to pass as context to AI pair programmers.  

Use `yarn install` to get started!

## Database Migrations

Run pending Drizzle migrations (PowerShell or any POSIX shell) with:

```sh
yarn db:migrate
```

This command reads `drizzle.config.ts`, targets `data/db.sqlite`, and keeps generated migration SQL under the `drizzle/` directory.

## To-Dos
