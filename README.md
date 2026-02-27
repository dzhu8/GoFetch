# GoFetch
Live index of your research library to identify related papers and answer research questions.  

Use `yarn install` to get started!

## Database Migrations

Run pending Drizzle migrations (PowerShell or any POSIX shell) with:

```sh
yarn db:migrate
```

This command reads `drizzle.config.ts`, targets `data/db.sqlite`, and keeps generated migration SQL under the `drizzle/` directory.

## Notes
For chat prompting, the complete user query is tried first. If there are no documents that are suitable for answering the user query, the application attempts to rephrase the question. If there are still no documents judged suitable for answering the query, the application will return a suggestion to lower the search threshold or upload files more suitable for question-answering. 
