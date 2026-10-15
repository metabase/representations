# Metabase Representation Format

The portable, file-based language for Metabase content: each entity is a YAML file (sometimes with sibling files) that an instance can export and pull back without numeric IDs.

## Language

### Custom visualizations

**Custom Viz Plugin**:
The installable unit that adds a visualization to an instance: a bundle plus the settings an admin keeps for it. Lives under `custom_viz_plugins/`.
_Avoid_: Custom visualization (when meaning the installed unit), viz plugin, visualization plugin, custom viz

**Custom Visualization**:
The display type a card picks when it renders with a Custom Viz Plugin, written as `custom:<identifier>`.
_Avoid_: Custom viz display, plugin display

**Identifier**:
The string that names a Custom Viz Plugin on an instance and in `custom:<identifier>` references. No `:`, `/`, `\` or whitespace, and no leading `.`.
_Avoid_: Slug, name (ambiguous with display name), plugin id

**Bundle**:
The tar.gz a Custom Viz Plugin ships as: a Manifest, the built JavaScript, and its assets, as the SDK's `pack` produces it. An instance stores the archive as uploaded, and a repository carries the same archive, base64, inside the plugin's entity file.
_Avoid_: Archive, zip, package, dist, bundle.tgz

**Manifest** (of a Custom Viz Plugin):
The `metabase-plugin.json` at the root of a Bundle: the plugin's name, icon, and the Metabase and SDK versions it was built for.
_Avoid_: Plugin config, package.json
