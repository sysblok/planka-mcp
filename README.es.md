# planka-mcp

Manejá un tablero Planka 2.x desde Claude Code mediante 24 tools MCP.
Las escrituras se releen y verifican: un éxito informado coincide con el board.
Un flujo opcional convierte ese board en memoria durable para el trabajo con agentes.

[Read in English](README.md)

```text
Vos hablás con Claude Code
          │
          ▼
  planka-mcp (stdio) ─── HTTPS + JSON ───▶ Planka 2.x
          │                                  │
          └──── vuelve a leer el resultado ◀─┘
```

> [!WARNING]
> El paquete viejo `@gogogadgetbytes/planka-mcp` puede informar éxito sin haber
> hecho nada en Planka 2.x. Leé [los cinco fallos silenciosos](docs/planka-2x-gotchas.md)
> antes de reemplazar una instalación existente.

## ¿Es tu primer MCP? Leé esto primero

MCP es un estándar que permite que Claude Code llame tools provistas por otro programa.
Este repo ejecuta un programa local pequeño que traduce esas llamadas a pedidos a la API de Planka.
Necesita credenciales de Planka porque actúa como un usuario dedicado de Planka, no como Claude.
Las credenciales quedan en tu máquina y nunca se escriben en el archivo de proyecto `.mcp.json`.
Claude Code carga los servidores MCP al iniciar una sesión, así que reinicialo después del setup o de cambiar la configuración.

## Requisitos

- Node.js 18 o posterior y `npm`
- Una instancia Planka 2.x accesible
- Un usuario dedicado de Planka que pueda ver el proyecto y board elegidos
- Claude Code instalado y disponible como `claude`
- Rol de project manager sólo si el setup debe crear un board

Funciona en Linux y macOS. Bun no es un requisito.

## Instalación en 5 minutos

Cloná el repo y ejecutá el instalador guiado:

```bash
git clone https://github.com/omnicoreos/planka-mcp.git
cd planka-mcp
./scripts/setup.sh
```

El setup pide la URL de Planka, email o usuario del agente y password. Valida esas
credenciales antes de escribir configuración, permite elegir o crear un board y
ejecuta un smoke real de crear, etiquetar, comentar y borrar una card.

Ofrece dos formas de configurar Claude Code:

| Opción | Cuándo usarla | Dónde vive |
|---|---|---|
| `claude mcp add` | Querés la instalación personal más simple | Configuración de usuario de Claude Code |
| `.mcp.json` de proyecto | Un equipo debe compartir la entrada del servidor | `<TU_PROYECTO>/.mcp.json`, se puede commitear |

En ambos casos, el setup guarda las credenciales fuera de Git en
`~/.config/planka-mcp/config.json` con modo `0600` y crea el launcher privado
`~/.local/bin/planka-mcp`. La configuración compartida no contiene el password:

```json
{
  "mcpServers": {
    "planka": {
      "type": "stdio",
      "command": "${HOME}/.local/bin/planka-mcp",
      "args": []
    }
  }
}
```

Podés volver a ejecutar el instalador. Actualiza la entrada `planka`, reutiliza las
listas y labels existentes del método y borra la card temporal del smoke test.

## Verificá que funciona

Primero, inspeccioná la configuración de Claude Code:

```bash
claude mcp list
claude mcp get planka
```

Después cerrá y volvé a abrir Claude Code por completo. Si elegiste `.mcp.json`,
abrí Claude Code dentro de ese proyecto y aprobá el servidor de proyecto cuando lo pida.

Pedile a Claude Code:

```text
Mostrame mis proyectos y boards de Planka. En la lista Pending, creá una card llamada
"MCP está funcionando" con la descripción "Creada desde Claude Code" y volvé a leerla.
```

Si Claude no ve las tools, reinicialo primero y después seguí
[Solución de problemas](docs/troubleshooting.md).

## Las 24 tools

Los IDs son strings. Empezá con `planka_get_structure` y usá los IDs que devuelve
Planka; no los adivines.

| Tool | Qué hace |
|---|---|
| `planka_get_structure` | Lista proyectos, boards y listas visibles |
| `planka_get_board` | Lee un board con listas, cards, labels y conteos opcionales de tareas |
| `planka_list_lists` | Lista las columnas de un board con sus conteos de cards, sin las cards |
| `planka_board_summary` | Resumen en una llamada: columnas, labels y las cards que esperan una decisión |
| `planka_list_cards` | Lee una sola columna, paginada y sin descripciones por defecto |
| `planka_find_cards` | Busca cards de un board por label, texto o columna |
| `planka_create_card` | Crea una card y puede agregar tareas y labels |
| `planka_get_card` | Lee el detalle completo de una card |
| `planka_update_card` | Actualiza título, descripción, vencimiento o estado de completado |
| `planka_move_card` | Mueve una card a otra lista o posición |
| `planka_delete_card` | Borra una card permanentemente |
| `planka_create_tasks` | Agrega tareas de checklist a una card |
| `planka_update_task` | Renombra o completa una tarea |
| `planka_delete_task` | Borra una tarea |
| `planka_manage_labels` | Crea, actualiza o borra labels del board |
| `planka_set_card_labels` | Agrega o quita labels y verifica el estado final |
| `planka_add_comment` | Agrega un comentario por el endpoint dedicado de Planka 2.x |
| `planka_get_comments` | Lee comentarios por el endpoint dedicado |
| `planka_manage_comment` | Edita o borra un comentario existente |
| `planka_manage_lists` | Crea, actualiza o borra listas del board |
| `planka_add_attachment` | Sube un archivo local a una card y verifica que quedó |
| `planka_get_attachments` | Lista los adjuntos de una card con tipo, tamaño y URL de descarga |
| `planka_view_attachment` | Devuelve el contenido de un adjunto; las imágenes vuelven visibles |
| `planka_delete_attachment` | Borra un adjunto |

`planka_get_board` devuelve el board entero, que suele ser más de lo que la
pregunta necesita. Las cuatro lecturas acotadas responden preguntas más chicas y
devuelven mucho menos texto: medido sobre un board de 100 cards,
`planka_list_lists` devolvió 39 veces menos que `planka_get_board`,
`planka_board_summary` 16 veces menos, y `planka_find_cards` entre 18 y 56 veces
menos según el filtro. Además informan `total`, `returned` y `hasMore`, así que
una respuesta recortada nunca parece completa.

Todos los campos y un payload completo por tool están en la
[referencia de tools](docs/tools.md).

## Flujo de agentes opcional

El servidor MCP funciona por sí solo. El método opcional resuelve otro problema:
preservar por qué existe un trabajo, qué cambió y qué sigue siendo cierto entre
sesiones de agentes.

Adoptalo por capas:

1. Usá sólo las tools MCP.
2. Sumá los estados del board, la plantilla de card y los handshakes humanos.
3. Sumá un worktree por card con un director que coordina obreros.

Empezá por [Un board que sobrevive a la sesión](workflow/README.md). La
[plantilla del board](workflow/board-template.md), las
[skills copiables de Claude Code](workflow/skills/) y el
[helper opcional de worktrees](workflow/worktrees/README.md) son piezas independientes.

## Solución de problemas

- [Síntomas, causas y fixes exactos](docs/troubleshooting.md)
- [Por qué Planka 2.x rompe MCP viejos en silencio](docs/planka-2x-gotchas.md)
- [Payloads completos de las tools](docs/tools.md)

Al reportar un bug, incluí la versión de Planka, la de Node, el nombre de la tool
y el texto del error. Nunca pegues credenciales ni access tokens.

## Créditos y licencia

Este es un fork con licencia MIT de
[`gogogadgetbytes/planka-mcp`](https://github.com/gogogadgetbytes/planka-mcp),
no una implementación original desde cero. [CREDITS.md](CREDITS.md) documenta
la atribución del upstream, los fixes mantenidos y los pull requests sin respuesta.

[LICENSE](LICENSE) conserva los avisos del autor original y de los contribuidores actuales.

## Desarrollo

```bash
npm ci
npm run build
npm test
```

El smoke real es opt-in porque modifica un board escribible y después limpia lo
creado. Ejercita las 24 tools por stdio y contrasta cada escritura contra la API
cruda de Planka: 64 checks con nombre.

```bash
export PLANKA_BASE_URL="https://planka.example.com"
export PLANKA_AGENT_EMAIL="agent@example.com"
export PLANKA_AGENT_PASSWORD="<TU_PASSWORD>"
export PLANKA_SMOKE_BOARD_ID="1234567890123456789"
npm run test:smoke
```

`npm run test:smoke` compila primero, así que no puede testear un `dist/` viejo.
Cuatro variables opcionales lo ajustan:

| Variable | Qué hace |
|---|---|
| `PLANKA_SMOKE_LIST_ID` | Columna donde se crea la card descartable. Sin esto elige una columna que parezca de descarte y, si no la hay, la primera |
| `PLANKA_SMOKE_FAIL_AFTER` | Inyecta un fallo después del check `<n>`, para probar que la limpieza igual corre |
| `PLANKA_MCP_ENTRY` | Punto de entrada del servidor. Por defecto `dist/index.js` |
| `VERBOSE` | Poné `1` para imprimir el payload de cada check |

Leé [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir un cambio. La identidad de
release está centralizada en [project.identity.json](project.identity.json):
actualizala y ejecutá `npm run sync:identity` antes de publicar con tu namespace.
