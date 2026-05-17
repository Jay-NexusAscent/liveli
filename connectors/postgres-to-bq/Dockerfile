FROM meltano/meltano:v3.7.1

WORKDIR /project

# Install the tap + target plugins ahead of time so each Cloud Run Job
# cold start doesn't repeat the pip install.
COPY meltano.yml ./
RUN meltano install

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
