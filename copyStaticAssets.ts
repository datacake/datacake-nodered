import * as shell from "shelljs";

shell.mkdir("-p", "dist/icons");
shell.cp("-R", "src/*.html", "dist/");
shell.cp("-R", "src/icons/*.svg", "dist/icons/");
