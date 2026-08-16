# Установка и запуск Code Agent

Пошаговая инструкция по установке и запуску проекта `code-agent`: локального AI-агента с веб-интерфейсом, PostgreSQL и Ollama.

Репозиторий: https://github.com/MisterBars/code-agent

---

## 1. Что понадобится установить

| Компонент | Зачем нужен |
|---|---|
| Git | Скачать код из GitHub |
| Python 3.10+ | Запуск приложения |
| PostgreSQL 14+ | Хранение диалогов и сообщений |
| Ollama | Локальный запуск ИИ-модели |
| Модель Ollama | Генерация ответов агентом |

---

## 2. Установка компонентов

### Windows

1. **Git** — [git-scm.com/download/win](https://git-scm.com/download/win)
2. **Python** — [python.org/downloads](https://www.python.org/downloads/) (при установке обязательно включить **Add Python to PATH**)
3. **PostgreSQL** — [postgresql.org/download/windows](https://www.postgresql.org/download/windows/)
4. **Ollama** — [ollama.com/download](https://ollama.com/download)

После установки откройте новое окно PowerShell и проверьте:

```powershell
git --version
python --version
psql --version
ollama --version
```

### Ubuntu / Debian

```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip postgresql postgresql-contrib
curl -fsSL https://ollama.com/install.sh | sh
```

Проверка:

```bash
git --version
python3 --version
psql --version
ollama --version
```

---

## 3. Скачивание проекта

### Вариант А: через Git

```bash
git clone https://github.com/MisterBars/code-agent.git
cd code-agent
```

### Вариант Б: без Git

1. Открыть страницу репозитория: https://github.com/MisterBars/code-agent
2. Нажать зелёную кнопку **Code**
3. Выбрать **Download ZIP**
4. Распаковать архив
5. Открыть терминал внутри папки `code-agent`

---

## 4. Настройка PostgreSQL

Нужно создать базу данных `code_agent`.

### Windows (SQL Shell / psql)

Запустить **SQL Shell (psql)**, на вопросы подключения можно нажимать Enter, ввести пароль от установки PostgreSQL, затем выполнить:

```sql
CREATE DATABASE code_agent;
\q
```

### Linux

```bash
sudo -u postgres psql
```

```sql
CREATE DATABASE code_agent;
\q
```

По желанию — отдельный пользователь для БД:

```sql
CREATE USER code_agent_user WITH PASSWORD 'надёжный_пароль';
CREATE DATABASE code_agent OWNER code_agent_user;
\q
```

---

## 5. Настройка Python-окружения

Все команды выполняются внутри папки `code-agent`.

### Windows PowerShell

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```

Если PowerShell блокирует активацию, один раз выполнить:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Перезапустить PowerShell и повторить активацию.

### Windows CMD

```bat
python -m venv .venv
.venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt
```

### Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
```

---

## 6. Настройка файла `.env`

Скопировать шаблон:

**Windows PowerShell:**
```powershell
Copy-Item .env.example .env
notepad .env
```

**Linux:**
```bash
cp .env.example .env
nano .env
```

Заполнить файл `.env`:

```env
DATABASE_URL=postgresql://postgres:ВАШ_ПАРОЛЬ@localhost:5432/code_agent

OLLAMA_URL=http://localhost:11434
DEFAULT_MODEL=qwen2.5-coder:7b
```

Если создан отдельный пользователь БД:

```env
DATABASE_URL=postgresql://code_agent_user:ВАШ_ПАРОЛЬ@localhost:5432/code_agent
```

**Важно:** если пароль PostgreSQL содержит символы `@ : / # %`, их нужно URL-кодировать. Например, пароль `MyP@ssword` в строке подключения записывается как `MyP%40ssword`.

---

## 7. Установка ИИ-модели

Убедиться, что Ollama работает:

```bash
ollama --version
```

Скачать модель:

```bash
ollama pull qwen2.5-coder:7b
```

Проверить, что модель загружена:

```bash
ollama list
```

### Выбор модели

| Модель | Команда | Когда использовать |
|---|---|---|
| `qwen2.5-coder:3b` | `ollama pull qwen2.5-coder:3b` | Слабый ПК, ответы проще |
| `qwen2.5-coder:7b` | `ollama pull qwen2.5-coder:7b` | Рекомендуемый старт, баланс качества и ресурсов |
| `qwen2.5-coder:14b` | `ollama pull qwen2.5-coder:14b` | Сложный код, требует больше RAM/VRAM |

Каталог всех доступных моделей: https://ollama.com/library

После выбора модели её имя нужно продублировать в `.env`, например:

```env
DEFAULT_MODEL=qwen2.5-coder:14b
```

---

## 8. Запуск проекта

Чек-лист перед стартом:

- [ ] PostgreSQL запущен
- [ ] Виртуальное окружение активировано
- [ ] Файл `.env` заполнен
- [ ] Модель скачана через `ollama pull`

Если Ollama не запущен, в отдельном терминале:

```bash
ollama serve
```

Оставить это окно открытым.

В другом терминале (с активированным `.venv`) выполнить запуск:

```bash
python main.py
```

При первом запуске приложение автоматически создаст таблицы `conversations` и `messages` в базе `code_agent`.

---

## 9. Открытие веб-интерфейса

После запуска `python main.py` открыть в браузере на том же компьютере:

```
http://127.0.0.1:8000
```

или

```
http://localhost:8000
```

Возможности интерфейса:

- создание новой беседы
- отправка задач агенту
- просмотр ответа и внутренних шагов планировщика/исполнителя
- переименование и удаление бесед
- оценка ответов агента (👍 / 👎)

---

## 10. Решение типичных проблем

### `KeyError: 'DATABASE_URL'`

Файл `.env` отсутствует или в нём нет строки `DATABASE_URL`.

```bash
cp .env.example .env
```

Заполнить `DATABASE_URL` и перезапустить `python main.py`.

### Ошибка подключения к PostgreSQL

Проверить подключение вручную:

```bash
psql "postgresql://postgres:ВАШ_ПАРОЛЬ@localhost:5432/code_agent"
```

Если базы нет:

```sql
CREATE DATABASE code_agent;
```

Проверить, запущен ли сервер PostgreSQL:

```powershell
# Windows
Get-Service *postgres*
```

```bash
# Linux
sudo systemctl status postgresql
sudo systemctl start postgresql   # если нужно запустить
```

### `No module named ...`

Виртуальное окружение не активировано или зависимости не установлены:

```bash
pip install -r requirements.txt
```

Перед этим обязательно активировать `.venv`.

### Агент не отвечает / ошибка подключения к Ollama

```bash
ollama list
ollama serve
curl http://localhost:11434/api/tags
```

Если модель не найдена:

```bash
ollama pull qwen2.5-coder:7b
```

Проверить, что название модели в `DEFAULT_MODEL` в `.env` точно совпадает с выводом `ollama list`.

---

## 11. Повторный запуск (после первой настройки)

```bash
cd code-agent
```

Активировать окружение:

```powershell
.venv\Scripts\Activate.ps1
```

```bash
source .venv/bin/activate
```

Убедиться, что PostgreSQL и Ollama запущены, затем:

```bash
python main.py
```

Открыть в браузере: `http://127.0.0.1:8000`
