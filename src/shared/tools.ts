// Every MCP tool an assistant gets, in plain words. Shown on the "Connect an assistant" page.
// The end-to-end test checks this list matches the tools the server actually offers.
export const ASSISTANT_TOOLS: { name: string; what: string; say: string; group: "Add" | "Study" | "Handwriting" | "Find" }[] = [
  { name: "add_note", group: "Add", what: "Adds text: headings, lists, checklists, code, tables, callouts and diagrams.", say: "Add this to my Work notes." },
  { name: "add_question", group: "Add", what: "A question card with the answer, key points and an optional diagram.", say: "Add this question to my Physics notes." },
  { name: "add_key_points", group: "Add", what: "A yellow box of the important points.", say: "Save the important points." },
  { name: "add_callout", group: "Add", what: "A coloured box: tip, definition, example, warning, summary or note.", say: "Add the definition of osmosis." },
  { name: "add_table", group: "Add", what: "An editable table with a coloured header.", say: "Compare arrays and linked lists in a table." },
  { name: "add_mind_map", group: "Add", what: "A colourful mind map of a topic and its branches.", say: "Make a mind map of this chapter." },
  { name: "add_diagram", group: "Add", what: "A flowchart, sequence, timeline or other diagram.", say: "Draw a flowchart of the login process." },
  { name: "add_map", group: "Add", what: "A map with numbered pins.", say: "Put these places on a map in my Trips notes." },
  { name: "add_board", group: "Add", what: "A task board with columns and cards you can move (To do, Doing, Done).", say: "Make a to-do board for my project." },
  { name: "add_image", group: "Add", what: "Saves an image into the notebook.", say: "Add that image to my notes." },
  { name: "summarize_notebook", group: "Study", what: "Reads a notebook and can save a summary into it.", say: "Summarise my Biology notes." },
  { name: "make_flashcards", group: "Study", what: "A deck of tap-to-flip flashcards for revision.", say: "Make flashcards from chapter 3." },
  { name: "read_handwriting", group: "Handwriting", what: "Looks at a picture of your handwritten pages.", say: "What did I write on page 2?" },
  { name: "convert_handwriting", group: "Handwriting", what: "Types out your handwriting, right after that page.", say: "Convert my handwriting on page 2 to text." },
  { name: "set_handwriting", group: "Handwriting", what: "Changes a notebook's look: neat handwriting (default), casual handwriting or print.", say: "Show my Biology notes in print." },
  { name: "list_notebooks", group: "Find", what: "Lists your notebooks and their topics.", say: "Which notebooks do I have?" },
  { name: "create_notebook", group: "Find", what: "Makes a new, empty notebook, optionally in a topic.", say: "Make a Chemistry notebook in my Science topic." },
  { name: "read_notebook", group: "Find", what: "Reads a notebook, so it can answer questions about it.", say: "What's in my DSA notes?" },
  { name: "search_notes", group: "Find", what: "Searches notebook names and everything typed in them.", say: "What did I note about recursion?" },
];
