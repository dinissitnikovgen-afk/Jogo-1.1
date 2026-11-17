# Brawl Web — Multiplayer com servidor central

Esta versão substitui PeerJS/WebRTC e as credenciais TURN do Metered por um servidor WebSocket central. O processo Node.js carrega o motor de jogo e executa a simulação de cada sala separadamente.

## O que mudou

- A simulação da partida (movimento, gravidade, ataques, colisões, projéteis, hazards, stocks e vencedor) corre no processo Node.js do servidor.
- Os dois browsers enviam apenas os seus comandos de jogo.
- O servidor simula a partida a 60 ticks por segundo e envia snapshots a 30 vezes por segundo.
- Os dois clientes usam interpolação visual para suavizar os snapshots.
- As salas usam códigos numéricos de 6 dígitos.
- O HTML já não contém credenciais Metered, PeerJS ou TURN.


## Otimizações de rede e estabilidade (v2)

**Servidor**
- Loop de simulação com acumulador: 60 ticks/s exatos (o `setInterval(16.67)` anterior arredondava para 16/17 ms).
- O HTML é lido e compilado uma só vez; cada sala só cria um contexto novo, e apenas quando a partida começa.
- Snapshots compactos: números arredondados e só as partículas novas (antes eram reenviadas 50 partículas a cada snapshot). Cada snapshot é serializado uma vez e enviado aos dois jogadores.
- Snapshots em ligações lentas são descartados em vez de acumulados (`bufferedAmount`).
- Toques curtos (premir e largar entre dois ticks) já não se perdem.
- Reconexão: se um jogador perder a ligação, a simulação pausa até 20 s e ele volta à mesma sala automaticamente.
- Heartbeat (ping a cada 15 s) para o proxy do Render não fechar ligações inativas e para detetar ligações mortas.
- Anti-flood, limite de salas (`MAX_ROOMS`), `try/catch` por sala (um erro não derruba o servidor) e encerramento limpo no `SIGTERM`.
- HTTP com gzip, ETag e `/healthz`.
- `SNAP_HZ` (20/30/60) configurável por variável de ambiente.

**Cliente**
- Interpolação com buffer de snapshots e atraso adaptativo ao jitter, independente do FPS do ecrã.
- Os inputs só são enviados quando mudam (antes 60 mensagens/s), com resync a cada segundo.
- Ao perder o foco do separador, as teclas são libertadas (evita personagem a andar sozinha).
- Reconexão automática com mensagem no ecrã e indicador de ping.

> Nota: o ficheiro `public/index.html` continua a ser a fonte do motor de jogo, por isso o servidor valida no arranque que os pontos de integração existem.

## Contas, Ranked e Leaderboard (v3)

**Contas**
- Botão **Cadastrar / Entrar** no menu (no lugar de "Convidado"). Nome (3–16 caracteres: letras, números, `_`, `-`) e senha (mínimo 4).
- As senhas são guardadas com `scrypt` + sal (nunca em texto simples). A sessão fica no browser e é revalidada no servidor.
- Bloqueio de 5 min após 5 senhas erradas na mesma conta e limite de pedidos por IP.
- As contas ficam em `DATA_DIR/users.json` (por omissão `./data/users.json`).

**Ranked** (exige conta; convidados veem a janela de login)
- Fila automática: o 1.º a entrar é o Jogador 1 e espera; quando entra o 2.º começa logo a escolha de personagens.
- Ambos escolhem o personagem (45 s; se não escolherem, é sorteado) e votam no mapa (25 s). Não há "Host" em ranked: o servidor avança sozinho.
- Sair a meio da partida ou perder a ligação mais de 20 s conta como **derrota** (e vitória para o adversário). Sair antes de a partida começar não altera o elo.
- Se os dois perderem a ligação, a partida é anulada.

**Elo**
- 1.ª partida ranked: **200** se ganhar, **150** se perder. A partir daí: **+50** por vitória e **-50** por derrota (nunca abaixo de 0).

**Leaderboard**
- Botão no menu principal: top 100 por elo (desempate por vitórias), com vitórias e derrotas. Só aparecem jogadores que já jogaram ranked.

**Nome sobre o personagem**
- Em partidas online mostra-se o nome da conta, pequeno, por cima de cada personagem (em salas de amigos sem conta aparece "Jogador 1/2").

**API HTTP:** `POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET /api/me`, `GET /api/leaderboard`.

### Persistência das contas (Postgres)
O disco do Render é **temporário**, por isso as contas ficam numa base de dados Postgres externa e gratuita (ex.: [Neon](https://neon.tech)).

1. Cria um projeto no Neon e copia a *connection string* (`postgresql://...`).
2. No Render: **Environment → Add Environment Variable** → `DATABASE_URL` = a string copiada.
3. Faz deploy. No log deve aparecer `armazenamento: Postgres`.

- A tabela `kv` é criada automaticamente no arranque; as contas e o elo ficam numa linha JSON (`key = 'users'`).
- Se `DATABASE_URL` não estiver definida, usa `DATA_DIR/users.json` (só para testes locais).
- Se a base de dados não responder no arranque, o servidor **aborta** em vez de arrancar vazio e sobrescrever contas.

## Executar localmente

1. Instala Node.js 20 ou superior.
2. Abre uma consola dentro da pasta `Brawl_Central`.
3. Executa:

   ```bash
   npm install
   npm start
   ```

4. Abre `http://localhost:3000` em dois browsers/dispositivos na mesma rede para testar.

Para testar a partir de outro dispositivo na mesma rede, usa o endereço IP local do computador que está a executar o servidor, por exemplo `http://192.168.1.20:3000`.

## Publicar no Render

1. Cria um repositório Git e coloca nele o conteúdo desta pasta (mantendo `public/index.html`).
2. No Render escolhe **New → Web Service** e liga o repositório.
3. Usa estas definições:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: escolhe um plano que mantenha o serviço ativo para partidas online regulares.
4. Depois do deploy, abre o URL HTTPS do Render. O cliente escolhe automaticamente `wss://` para o WebSocket.

O servidor e o HTML são servidos pelo mesmo serviço, portanto não precisas de configurar CORS nem outro domínio.

## Limitações e notas

- O servidor é autoritativo para a simulação, mas o tempo de resposta continua dependente da distância entre os jogadores e a região do Render.
- O plano gratuito do Render pode suspender serviços inativos; isso pode causar atraso na primeira ligação depois de algum tempo sem uso.
- Esta implementação foi preparada a partir do HTML fornecido. O ficheiro JavaScript do cliente e o servidor passaram validação de sintaxe. O motor de simulação foi executado em teste isolado a 60 ticks por segundo. Ainda é necessário testar partidas reais entre dois dispositivos, incluindo seleção, votação, ataques, quedas e fim de jogo.
- O código de sala é de 6 dígitos, mas não é um sistema de contas nem de matchmaking público. Partilha o código apenas com quem queres convidar.

## Segurança

O HTML de origem continha credenciais TURN/Metered embutidas. Esta versão remove-as, mas deves **revogar/rodar essas credenciais no painel Metered**, porque já estiveram expostas no código partilhado.
