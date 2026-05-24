FROM meltano/meltano:v3.7.1-python3.11
WORKDIR /project
COPY meltano.yml ./
RUN meltano lock --update --all && meltano install
RUN .meltano/loaders/target-bigquery/venv/bin/pip install 'setuptools<81'
RUN pip install --no-cache-dir gcsfs google-cloud-storage
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
ENTRYPOINT ["./entrypoint.sh"]
