# NEEDS_BUN: croft was started with Node or another runtime instead of Bun

croft is a Bun program: its CLI, the asset code it runs and its database driver setup all run on Bun. It was
started some other way (node on the bin file, a Node-based runner, a shell alias), and stops at once.

Nothing ran.

What to do:
- Bun is not installed: ask the user to install it (curl -fsSL https://bun.sh/install | bash, or their package
  manager), then run croft again. croft doctor checks the setup.
- Bun is installed: run croft directly (croft <command>, or bunx croft <command> in the project), not through node.
Apps that only read data can use @zabaca/croft/read from Node; running pipelines needs Bun.
