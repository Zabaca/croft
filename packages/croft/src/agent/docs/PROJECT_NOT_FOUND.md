# PROJECT_NOT_FOUND: no croft project here

Most croft commands work on a project: the folder that holds croft.json. croft looks for it in the current folder,
then in each parent folder, then in a data/ folder of the current one (a project inside an app). PROJECT_NOT_FOUND
means none of them has a croft.json, or croft.json cannot be read. The read helper (@zabaca/croft/read) raises it
too when CROFT_PROJECT or its { project } option points at a folder without croft.json.

Nothing was changed.

What to do:
- Run the command from inside the project folder (cd to the folder with croft.json, or to the app whose data/
  holds it).
- There is no project yet: ask the user where it should live, then croft init <dir> (or croft init inside an
  existing app, which puts the project in data/).
- croft init --claude only refreshes the Claude files of an existing project, so it needs one too.
- An app reading the warehouse: set CROFT_PROJECT, or pass { project: "/path/to/data" }, to the folder that holds
  croft.json.
